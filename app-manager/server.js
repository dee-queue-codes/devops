import express from 'express';
import Docker from 'dockerode';
import path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';
import handlebars from 'handlebars';
import cors from 'cors';
import simpleGit from 'simple-git';
import fs from 'fs-extra';
import * as tar from 'tar';
import { exec } from 'child_process';
import { promisify } from 'util';
import { WebSocketServer } from 'ws';
import http from 'http';

// Global WebSocket variables
const wsConnections = new Map();

// Function to send WebSocket messages
export function sendWebSocketMessage(appName, message) {
    const ws = wsConnections.get(appName);
    if (ws && ws.readyState === ws.OPEN) {  // Fixed WebSocket.OPEN to ws.OPEN
        ws.send(JSON.stringify({
            timestamp: new Date().toISOString(),
            appName,
            ...message
        }));
        console.log(`📤 Sent WebSocket message to ${appName}:`, message);
    } else {
        console.log(`⚠️ No WebSocket connection for ${appName} or connection is closed`);
    }
}

export function broadcastMessage(message) {
    wsConnections.forEach((ws, appName) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                timestamp: new Date().toISOString(),
                broadcast: true,
                ...message
            }));
        }
    });
    console.log(`📡 Broadcasted message to ${wsConnections.size} clients:`, message);
}


// Initialize Express app
const git = simpleGit();
const execAsync = promisify(exec);
const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.use(express.json());

app.use(cors({
    origin: 'http://localhost:8080', // or '*' to allow all origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));


// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({
    server,
    path: '/ws'  // WebSocket endpoint will be ws://localhost:3002/ws
});


// WebSocket connection handling - FIXED
wss.on('connection', (ws, req) => {
    console.log('🔌 New WebSocket connection established');

    // Extract app name from query parameters or headers
    const url = new URL(req.url, `http://${req.headers.host}`);
    const appName = url.searchParams.get('app') || 'default';

    console.log(`📱 WebSocket connection for app: ${appName}`);

    // Store the connection
    wsConnections.set(appName, ws);

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'connection',
        message: `Connected to app-manager WebSocket for ${appName}`,
        timestamp: new Date().toISOString(),
        appName
    }));

    // Handle incoming messages from client
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log(`📥 Received message from ${appName}:`, message);

            // Echo back or handle specific commands
            if (message.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: new Date().toISOString(),
                    appName
                }));
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid JSON format',
                timestamp: new Date().toISOString()
            }));
        }
    });

    // Handle connection close
    ws.on('close', (code, reason) => {
        console.log(`🔌 WebSocket connection closed for ${appName}: ${code} - ${reason}`);
        wsConnections.delete(appName);
    });

    // Handle errors
    ws.on('error', (error) => {
        console.error(`❌ WebSocket error for ${appName}:`, error);
        wsConnections.delete(appName);
    });
});

// WebSocket server error handling
wss.on('error', (error) => {
    console.error('❌ WebSocket Server error:', error);
});

// Add endpoint to check WebSocket connections
app.get('/api/websocket/status', (req, res) => {
    const connections = Array.from(wsConnections.keys());
    res.json({
        activeConnections: connections.length,
        connectedApps: connections,
        wsServerRunning: wss.clients.size > 0
    });
});

// Test endpoint to send WebSocket message
app.post('/api/websocket/test', (req, res) => {
    const { appName, message } = req.body;

    if (!appName || !message) {
        return res.status(400).json({ error: 'appName and message are required' });
    }

    sendWebSocketMessage(appName, {
        type: 'test',
        message: message
    });

    res.json({ success: true, message: `Test message sent to ${appName}` });
});


// Add this near the top of your file where you initialize handlebars
handlebars.registerHelper('eq', function (a, b, options) {
    if (arguments.length < 3) {
        throw new Error('Handlebars Helper "eq" needs 2 parameters');
    }

    if (a === b) {
        return options.fn(this);
    }
    return options.inverse ? options.inverse(this) : '';
});

// Dockerfile templates for different app types
const dockerfileTemplates = {
    node: `FROM node:{{nodeVersion}}-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
{{#if buildCommand}}
RUN {{buildCommand}}
{{/if}}
EXPOSE {{port}}
{{#if healthCheck}}
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \\
  CMD {{healthCheck}} || exit 1
{{/if}}
{{#each startCommands}}
{{#if @first}}CMD [{{#each this}}"{{this}}"{{#unless @last}}, {{/unless}}{{/each}}]{{/if}}
{{/each}}`,
    java: `# Build stage
FROM eclipse-temurin:{{javaVersion}}-jdk-jammy as builder
WORKDIR /app
COPY . .

{{#if isMaven}}
# For Maven
COPY pom.xml .
COPY src ./src
RUN ./mvnw clean package -DskipTests
{{else}}
RUN ./gradlew clean bootJar --no-daemon
{{/if}}

# Runtime stage
FROM eclipse-temurin:{{javaVersion}}-jre-jammy
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Copy the built JAR from the builder stage
{{#if isMaven}}
COPY --from=builder /app/target/*.jar app.jar
{{else}}
COPY --from=builder /app/build/libs/*.jar app.jar
{{/if}}

# Set non-root user
RUN addgroup --system spring && adduser --system --group spring
RUN chown spring:spring app.jar
USER spring:spring

# Expose and run
EXPOSE {{port}}
{{#if healthCheck}}
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \\
  CMD {{healthCheck}} || exit 1
{{/if}}
{{#each startCommands}}
{{#if @first}}CMD [{{#each this}}"{{this}}"{{#unless @last}}, {{/unless}}{{/each}}]{{/if}}
{{/each}}`,
    python: `FROM python:{{pythonVersion}}-slim
WORKDIR /app
{{#if requirements}}
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
{{/if}}
COPY . .
{{#if buildCommand}}
RUN {{buildCommand}}
{{/if}}
EXPOSE {{port}}
{{#if healthCheck}}
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \\
  CMD {{healthCheck}} || exit 1
{{/if}}
{{#each startCommands}}
{{#if @first}}CMD [{{#each this}}"{{this}}"{{#unless @last}}, {{/unless}}{{/each}}]{{/if}}
{{/each}}`,

    go: `FROM golang:{{goVersion}}-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

FROM alpine:latest
RUN apk --no-cache add ca-certificates curl
WORKDIR /root/
COPY --from=builder /app/main .
EXPOSE {{port}}
{{#if healthCheck}}
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \\
  CMD {{healthCheck}} || exit 1
{{/if}}
{{#each startCommands}}
{{#if @first}}CMD [{{#each this}}"{{this}}"{{#unless @last}}, {{/unless}}{{/each}}]{{/if}}
{{/each}}`,

    php: `FROM php:{{phpVersion}}-apache
{{#if extensions}}
RUN docker-php-ext-install {{extensions}}
{{/if}}
COPY . /var/www/html/
{{#if buildCommand}}
RUN {{buildCommand}}
{{/if}}
EXPOSE {{port}}
{{#if healthCheck}}
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \\
  CMD {{healthCheck}} || exit 1
{{/if}}
{{#each startCommands}}
{{#if @first}}CMD [{{#each this}}"{{this}}"{{#unless @last}}, {{/unless}}{{/each}}]{{/if}}
{{/each}}`,

    custom: `FROM {{baseImage}}
WORKDIR /app
{{#each customInstructions}}
{{this}}
{{/each}}
COPY . .
{{#if buildCommand}}
RUN {{buildCommand}}
{{/if}}
EXPOSE {{port}}
{{#if healthCheck}}
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \\
  CMD {{healthCheck}} || exit 1
{{/if}}
{{#each startCommands}}
{{#if @first}}CMD [{{#each this}}"{{this}}"{{#unless @last}}, {{/unless}}{{/each}}]{{/if}}
{{/each}}`
};

// Database configurations
const databaseConfigs = {
    postgresql: {
        image: 'postgres:16',
        envVars: {
            'POSTGRES_DB': '{{dbName}}',
            'POSTGRES_USER': '{{dbUser}}',
            'POSTGRES_PASSWORD': '{{dbPassword}}'
        },
        dataPath: '/var/lib/postgresql/data',
        port: 5432
    },
    mysql: {
        image: 'mysql:8.0',
        envVars: {
            'MYSQL_DATABASE': '{{dbName}}',
            'MYSQL_USER': '{{dbUser}}',
            'MYSQL_PASSWORD': '{{dbPassword}}',
            'MYSQL_ROOT_PASSWORD': '{{dbPassword}}'
        },
        dataPath: '/var/lib/mysql',
        port: 3306
    },
    mongodb: {
        image: 'mongo:7',
        envVars: {
            'MONGO_INITDB_DATABASE': '{{dbName}}',
            'MONGO_INITDB_ROOT_USERNAME': '{{dbUser}}',
            'MONGO_INITDB_ROOT_PASSWORD': '{{dbPassword}}'
        },
        dataPath: '/data/db',
        port: 27017
    },
    redis: {
        image: 'redis:7-alpine',
        envVars: {},
        dataPath: '/data',
        port: 6379,
        command: ['redis-server', '--requirepass', '{{dbPassword}}']
    }
};

// Create new app endpoint
app.post('/api/apps/create', async (req, res) => {
    try {
        const {
            name,
            githubRepo,
            credentials,
            environment,
            port,
            appType,
            appConfig,
            database,
            startCommands,
            buildCommand,
            healthCheck
        } = req.body;

        console.log('🚀 Creating new app:', name);

        // Validate inputs
        if (!name || !githubRepo || !port || !appType || !startCommands) {
            return res.status(400).json({
                error: 'Missing required fields: name, githubRepo, port, appType, startCommands'
            });
        }

        // Immediately send initial response
        res.json({
            success: true,
            message: `App ${name} creation started`,
            status: 'in_progress',
            port: port,
            url: `http://localhost:8080/${name}/`,
            websocketUrl: `ws://localhost:3002/ws?app=${name}`
        });

        // Send initial WebSocket message
        sendWebSocketMessage(name, {
            type: 'creation_started',
            message: `Starting creation of app ${name}`,
            status: 'in_progress',
            progress: 0
        });

        // Start async process
        const processAppCreation = async () => {
            try {
                // Check if port is already in use
                const existingCompose = await readDockerCompose();
                const usedPorts = getUsedPorts(existingCompose);
                if (usedPorts.includes(port)) {
                    sendWebSocketMessage(name, {
                        type: 'error',
                        error: `Port ${port} is already in use. Available ports: ${getAvailablePorts(usedPorts).join(', ')}`,
                        status: 'failed'
                    });
                    return;
                }

                // Clone repository
                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'Cloning repository...',
                    progress: 20
                });

                const repoPath = await cloneRepository(githubRepo, credentials.githubPAT, name);

                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'Repository cloned successfully',
                    progress: 40
                });

                // Generate Dockerfile
                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'Generating Dockerfile...',
                    progress: 50
                });

                await generateDockerfile(repoPath, appType, appConfig, port, startCommands, buildCommand, healthCheck);

                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'Dockerfile generated successfully',
                    progress: 60
                });

                // Update docker-compose.yml
                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'Updating docker-compose.yml...',
                    progress: 70
                });

                await updateDockerCompose(name, port, environment, database, appConfig);

                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'docker-compose.yml updated successfully',
                    progress: 80
                });

                // Update nginx configuration
                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'Updating nginx configuration...',
                    progress: 85
                });

                await updateNginxConfig(name, port);

                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'nginx configuration updated successfully',
                    progress: 90
                });

                // Build and start the new services
                sendWebSocketMessage(name, {
                    type: 'progress',
                    message: 'Building and starting services...',
                    progress: 95
                });

                await buildAndStartServices(name);

                sendWebSocketMessage(name, {
                    type: 'completion',
                    message: 'Services built and started successfully',
                    status: 'completed',
                    progress: 100,
                    url: `http://localhost:8080/${name}/`,
                    healthCheckUrl: `http://localhost:8080/${name}/health-check`
                });

            } catch (error) {
                console.error('❌ Error creating app:', error);
                sendWebSocketMessage(name, {
                    type: 'error',
                    error: error.message,
                    status: 'failed'
                });
            }
        };

        // Start the async process
        processAppCreation();

    } catch (error) {
        console.error('❌ Error creating app:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get available ports
app.get('/api/ports/available', async (req, res) => {
    try {
        const existingCompose = await readDockerCompose();
        const usedPorts = getUsedPorts(existingCompose);
        const availablePorts = getAvailablePorts(usedPorts);

        res.json({
            usedPorts,
            availablePorts: availablePorts.slice(0, 10) // Return first 10 available
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get app templates/examples
app.get('/api/apps/templates', (req, res) => {
    const templates = {
        node: {
            versions: ['18', '20', 'latest'],
            defaultStartCommands: [['npm', 'start']],
            exampleStartCommands: [
                ['npm', 'start'],
                ['node', 'server.js'],
                ['npm', 'run', 'production'],
                ['node', 'dist/index.js']
            ],
            buildCommands: ['npm run build', 'npm run compile'],
            healthCheck: 'curl -f http://localhost:{{port}}/health || wget --no-verbose --tries=1 --spider http://localhost:{{port}}/health'
        },
        java: {
            versions: ['11', '17', '21'],
            buildTools: ['maven', 'gradle'],
            defaultStartCommands: [['java', '-jar', 'app.jar']],
            exampleStartCommands: [
                ['java', '-jar', 'app.jar'],
                ['java', '-Dspring.profiles.active=production', '-jar', 'app.jar'],
                ['java', '-Xmx1g', '-jar', 'app.jar']
            ],
            healthCheck: 'curl -f http://localhost:{{port}}/actuator/health'
        },
        python: {
            versions: ['3.9', '3.10', '3.11', '3.12'],
            defaultStartCommands: [['python', 'app.py']],
            exampleStartCommands: [
                ['python', 'app.py'],
                ['python', 'manage.py', 'runserver', '0.0.0.0:{{port}}'],
                ['gunicorn', '--bind', '0.0.0.0:{{port}}', 'app:app'],
                ['uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '{{port}}']
            ],
            buildCommands: ['pip install -r requirements.txt'],
            healthCheck: 'curl -f http://localhost:{{port}}/health'
        },
        go: {
            versions: ['1.20', '1.21', '1.22'],
            defaultStartCommands: [['./main']],
            exampleStartCommands: [
                ['./main'],
                ['./app'],
                ['go', 'run', 'main.go']
            ],
            buildCommands: ['go build -o main .'],
            healthCheck: 'curl -f http://localhost:{{port}}/health'
        },
        php: {
            versions: ['8.1', '8.2', '8.3'],
            extensions: ['pdo', 'pdo_mysql', 'mysqli', 'json'],
            defaultStartCommands: [['apache2-foreground']],
            exampleStartCommands: [
                ['apache2-foreground'],
                ['php', '-S', '0.0.0.0:{{port}}'],
                ['php-fpm']
            ],
            healthCheck: 'curl -f http://localhost:{{port}}/health.php'
        }
    };

    res.json(templates);
});

// Delete app endpoint
app.delete('/api/apps/:name', async (req, res) => {
    try {
        const { name } = req.params;

        // Stop and remove containers
        execSync(`docker-compose stop ${name} ${name}-db`, { stdio: 'inherit' });
        execSync(`docker-compose rm -f ${name} ${name}-db`, { stdio: 'inherit' });

        // Remove from docker-compose.yml
        const compose = await readDockerCompose();
        delete compose.services[name];
        delete compose.services[`${name}-db`];
        if (compose.volumes) {
            delete compose.volumes[`${name}_data`];
        }
        await fs.writeFile('./docker-compose.yml', yaml.dump(compose, { indent: 2 }));

        // Remove from nginx config
        // TODO: Implement nginx cleanup

        // Remove app directory
        await fs.rmdir(`./${name}`, { recursive: true });

        res.json({ success: true, message: `App ${name} deleted successfully` });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/apps/compose', async (req, res) => {
    try {
        const compose = await readDockerCompose();
        res.json(compose);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Helper functions
async function cloneRepository(repoUrl, token, name) {
    try {
        const appsDir = path.join(process.cwd(), 'apps');
        const repoPath = path.join(appsDir, name);

        // Remove existing directory if it exists
        if (await fs.pathExists(repoPath)) {
            await fs.remove(repoPath);
        }
        await fs.mkdirp(appsDir);

        // Clone with authentication
        const repoUrlWithAuth = `https://${token}@${repoUrl.replace('https://', '')}`;
        await git.clone(repoUrlWithAuth, repoPath);

        console.log(`Repository cloned to ${repoPath}`);
        return repoPath;
    } catch (error) {
        console.error('Error cloning repository:', error);
        throw error;
    }
}

async function generateDockerfile(repoPath, appType, appConfig, port, startCommands, buildCommand, healthCheck) {
    try {
        const template = handlebars.compile(dockerfileTemplates[appType] || dockerfileTemplates.custom);

        const templateData = {
            port,
            startCommands: [startCommands], // Wrap in array for template
            buildCommand,
            healthCheck,
            isMaven: appConfig.buildTool === 'maven',
            isGradle: appConfig.buildTool === 'gradle',
            ...appConfig
        };

        const dockerfile = template(templateData);
        await fs.writeFile(path.join(repoPath, 'Dockerfile'), dockerfile);
    } catch (error) {
        console.error('Error generating Dockerfile:', error);
        throw error;
    }
}

async function readDockerCompose() {
    try {
        const composePath = process.env.HOST_PROJECT_ROOT
            ? path.join(process.env.HOST_PROJECT_ROOT, 'docker-compose.yml')
            : path.join(__dirname, '..', 'docker-compose.yml');

        console.log('Looking for docker-compose at:', composePath);
        console.log('Current directory:', process.cwd());

        // Use fs.promises for Promise-based filesystem operations
        const dirContents = await fs.promises.readdir(path.dirname(composePath));
        console.log('Directory contents:', dirContents);

        const composeContent = await fs.promises.readFile(composePath, 'utf8');
        return yaml.load(composeContent);
    } catch (error) {
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            path: error.path,
            stack: error.stack
        });
        throw new Error('Could not read docker-compose.yml');
    }
}

async function updateDockerCompose(name, port, environment = {}, database, appConfig) {
    try {
        const composePath = path.join(process.env.HOST_PROJECT_ROOT, 'docker-compose.yml');
        const compose = await readDockerCompose();

        // Add/update app service
        compose.services[name] = {
            build: {
                context: `./app-manager/apps/${name}`,
                dockerfile: 'Dockerfile'
            },
            container_name: name,
            expose: [port.toString()],
            environment: {
                SERVER_PORT: port,
                ...environment
            },
            networks: ['projects-network']
        };

        // Add database if needed
        if (database?.type && database.type !== 'none') {
            const dbConfig = databaseConfigs[database.type];
            const dbName = `${name}-db`;

            // Database service
            compose.services[dbName] = {
                image: dbConfig.image,
                container_name: dbName,
                environment: Object.entries(dbConfig.envVars).reduce((acc, [key, template]) => {
                    acc[key] = template
                        .replace('{{dbName}}', database.name || `${name}_db`)
                        .replace('{{dbUser}}', database.credentials?.username || `${name}_user`)
                        .replace('{{dbPassword}}', database.credentials?.password || 'password123');
                    return acc;
                }, {}),
                volumes: [`${name}_data:${dbConfig.dataPath}`],
                networks: ['projects-network']
            };

            // Add dependency
            compose.services[name].depends_on = [dbName];

            // Add database URL
            compose.services[name].environment.DATABASE_URL = generateDatabaseUrl(
                database.type,
                dbName,
                dbConfig.port,
                database
            );

            // Add volume
            if (!compose.volumes) compose.volumes = {};
            compose.volumes[`${name}_data`] = null;
        }

        // Write back to the main docker-compose.yml
        await fs.writeFile(composePath, yaml.dump(compose));
        console.log('Updated main docker-compose.yml');
    } catch (error) {
        console.error('Error updating docker-compose.yml:', error);
        throw error;
    }
}

function generateDatabaseUrl(dbType, dbName, dbPort, database) {
    const dbUser = database.credentials?.username || `${database.name}_user`;
    const dbPassword = database.credentials?.password || 'password123';
    const dbDatabase = database.name || `${database.name}_db`;

    switch (dbType) {
        case 'postgresql':
            return `postgresql://${dbUser}:${dbPassword}@${dbName}:${dbPort}/${dbDatabase}`;
        case 'mysql':
            return `mysql://${dbUser}:${dbPassword}@${dbName}:${dbPort}/${dbDatabase}`;
        case 'mongodb':
            return `mongodb://${dbUser}:${dbPassword}@${dbName}:${dbPort}/${dbDatabase}`;
        default:
            return '';
    }
}

async function updateNginxConfig(name, port) {
    try {
        //         const configContent = `
        // # Configuration for ${name}
        // upstream ${name} {
        //     server ${name}:${port};
        // }

        // server {
        //     listen 80;
        //     server_name _;

        //     # Route to ${name} app on port ${port}
        //     location /${name}/ {
        //         proxy_pass http://${name}/;
        //         proxy_http_version 1.1;
        //         proxy_set_header Host $host;
        //         proxy_set_header X-Real-IP $remote_addr;
        //         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        //         proxy_set_header X-Forwarded-Proto $scheme;
        //         proxy_set_header X-Forwarded-Prefix /${name};
        //         proxy_set_header Upgrade $http_upgrade;
        //         proxy_set_header Connection 'upgrade';
        //         proxy_cache_bypass $http_upgrade;
        //     }
        // }`;
        const configContent = `
# Configuration for ${name}
# Using variables instead of upstream blocks to avoid startup failures

# Main location block for ${name}
location /${name}/ {
    # Dynamic upstream resolution - resolves at request time
    set $upstream_${name} ${name}:${port};
    
    # Remove the prefix before proxying
    rewrite ^/${name}(/.*)$ $1 break;
    
    proxy_pass http://$upstream_${name};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /${name};
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_cache_bypass $http_upgrade;
    
    # Timeout settings
    proxy_connect_timeout 5s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
    
    # Handle upstream errors gracefully
    proxy_intercept_errors on;
    error_page 502 503 504 = @${name}_error;
}

# Error handling location for ${name}
location @${name}_error {
    return 503 '{
        "error": "Service ${name} is temporarily unavailable",
        "service": "${name}",
        "timestamp": "$time_iso8601",
        "message": "The service may be starting up or experiencing issues. Please try again in a few moments."
    }';
    add_header Content-Type application/json;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
}

# Health check endpoint for ${name}
location /${name}/health-check {
    set $upstream_${name} ${name}:${port};
    proxy_pass http://$upstream_${name}/actuator/health;
    proxy_set_header Host $host;
    proxy_connect_timeout 2s;
    proxy_send_timeout 2s;  
    proxy_read_timeout 2s;
    
    # Return structured response even on failure
    proxy_intercept_errors on;
    error_page 502 503 504 = @${name}_health_error;
}

location @${name}_health_error {
    return 503 '{
        "status": "DOWN",
        "service": "${name}",
        "timestamp": "$time_iso8601"
    }';
    add_header Content-Type application/json;
}`;


        // Write to a temporary file
        const tempFile = `/tmp/${name}.conf`;
        await fs.promises.writeFile(tempFile, configContent);

        // Create a tar archive
        const tarStream = tar.c({
            gzip: false,
            cwd: '/tmp'
        }, [`${name}.conf`]);

        // Get nginx container
        const nginxContainer = docker.getContainer(process.env.NGINX_CONTAINER_NAME || 'devops-nginx-1');

        // Put the archive in conf.d
        await new Promise((resolve, reject) => {
            nginxContainer.putArchive(tarStream, {
                path: '/etc/nginx/conf.d',
                noOverwriteDirNonDir: true
            }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Clean up
        await fs.promises.unlink(tempFile);

        // Test nginx configuration
        console.log('Testing nginx configuration...');
        await testNginxConfig(nginxContainer);

        // Reload nginx
        console.log('Reloading nginx...');
        await reloadNginx(nginxContainer);

        console.log(`Successfully added configuration for ${name}`);
    } catch (error) {
        console.error('Error updating nginx config:', error);
        throw error;
    }
}

async function testNginxConfig(nginxContainer) {
    const testExec = await nginxContainer.exec({
        Cmd: ['nginx', '-t'],
        AttachStdout: true,
        AttachStderr: true
    });

    return new Promise((resolve, reject) => {
        testExec.start({}, (err, stream) => {
            if (err) return reject(err);

            let output = '';
            let errorOutput = '';

            // Capture both stdout and stderr
            stream.on('data', (chunk) => {
                const data = chunk.toString();
                output += data; // Capture all output
                if (!data.includes('syntax is ok') || !data.includes('test is successful')) {
                    errorOutput += data; // Only capture errors
                }
            });

            stream.on('end', () => {
                // Check if we have both success messages
                if (output.includes('syntax is ok') && output.includes('test is successful')) {
                    console.log('✅ Nginx configuration test passed');
                    resolve();
                } else {
                    console.error('❌ Nginx configuration test failed:', errorOutput);
                    reject(new Error('Nginx configuration test failed: ' + errorOutput));
                }
            });

            stream.on('error', reject);
        });
    });
}

async function reloadNginx(nginxContainer) {
    const reloadExec = await nginxContainer.exec({
        Cmd: ['nginx', '-s', 'reload'],
        AttachStdout: true,
        AttachStderr: true
    });

    return new Promise((resolve, reject) => {
        reloadExec.start({}, (err, stream) => {
            if (err) return reject(err);

            let output = '';
            stream.on('data', (chunk) => {
                output += chunk.toString();
            });

            stream.on('end', () => {
                console.log('✅ Nginx reloaded successfully');
                resolve();
            });

            stream.on('error', reject);
        });
    });
}

async function removeNginxConfig(name) {
    try {
        const nginxContainer = docker.getContainer(process.env.NGINX_CONTAINER_NAME || 'devops-nginx-1');

        // Remove the config file
        const removeExec = await nginxContainer.exec({
            Cmd: ['rm', '-f', `/etc/nginx/conf.d/${name}.conf`],
            AttachStdout: true,
            AttachStderr: true
        });

        await new Promise((resolve, reject) => {
            removeExec.start({}, (err, stream) => {
                if (err) return reject(err);
                stream.on('end', resolve);
                stream.on('error', reject);
                stream.resume();
            });
        });

        // Test and reload nginx
        await testNginxConfig(nginxContainer);
        await reloadNginx(nginxContainer);

        console.log(`✅ Removed nginx configuration for ${name}`);
    } catch (error) {
        console.error('Error removing nginx config:', error);
        throw error;
    }
}

async function rebuildAndRestartService({ composeFile, projectName, service, cwd }) {
    try {
        console.log(`Rebuilding service: ${service} in project: ${projectName}...`);
        const { stdout, stderr } = await execAsync(
            `docker-compose -f ${composeFile} -p ${projectName} build ${service}`,
            { cwd }
        );
        console.log(stdout);
        console.error(stderr);
        console.log(`Build complete.`);

        console.log(`Restarting service: ${service}...`);
        const { stdout: restartStdout, stderr: restartStderr } = await execAsync(
            `docker-compose -f ${composeFile} -p ${projectName} up -d ${service}`,
            { cwd }
        );

        console.log(restartStdout);
        console.error(restartStderr);
        console.log(`Service restarted successfully.`);
    } catch (err) {
        console.error(`Error during rebuild/restart:`, err.message);
    }
}

async function buildAndStartServices(name) {
    try {
        const composePath = process.env.HOST_PROJECT_ROOT
            ? path.join(process.env.HOST_PROJECT_ROOT, 'docker-compose.yml')
            : path.join(__dirname, '..', 'docker-compose.yml');

        console.log(`Starting deployment process for ${name}...`);
        console.log(`Compose file contents: ${fs.readFileSync(composePath, 'utf8')}`);

        // Step 1: Build and start the service
        console.log('📦 Building and starting service...');
        await rebuildAndRestartService({
            composeFile: composePath,
            projectName: process.env.COMPOSE_PROJECT_NAME,
            service: name,
            cwd: process.env.HOST_PROJECT_ROOT
        });

        // Step 2: Wait for services to be ready
        console.log('⏳ Waiting for services to start up...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Step 3: Update nginx configuration (this won't fail even if service is down)
        console.log('🔧 Updating nginx configuration...');
        const port = getServicePort(name); // You'll need to implement this
        await updateNginxConfig(name, port);

        // Step 4: Verify service health (optional, non-blocking)
        console.log('🏥 Checking service health...');
        try {
            await waitForServiceHealth(name, 5); // Wait up to 20 seconds
            console.log(`✅ Service ${name} is healthy and ready`);
        } catch (healthError) {
            console.warn(`⚠️  Service ${name} health check failed, but nginx config is in place:`, healthError.message);
        }

        console.log(`🎉 Deployment completed for ${name}`);

    } catch (error) {
        console.error('❌ Error during deployment:', error);
        throw error;
    }
}

function getServicePort(serviceName) {
    try {
        const composePath = path.join(process.env.HOST_PROJECT_ROOT, 'docker-compose.yml');
        const composeContent = fs.readFileSync(composePath, 'utf8');
        const compose = yaml.load(composeContent);

        const service = compose.services[serviceName];
        if (service && service.expose && service.expose.length > 0) {
            return parseInt(service.expose[0]);
        }

        // Fallback: try to get from environment
        if (service && service.environment && service.environment.SERVER_PORT) {
            return parseInt(service.environment.SERVER_PORT);
        }

        throw new Error(`Could not determine port for service ${serviceName}`);
    } catch (error) {
        console.error('Error getting service port:', error);
        throw error;
    }
}

async function checkHealth(appName) {
    try {
        // const SERVER_URL = 'http://localhost:8080';
        // const response = await fetch(`${SERVER_URL}/${appName}/health-check`, {
        //     timeout: 5000
        // })
        // Get the actual port from the service configuration
        console.log(`http://localhost:8080/${appName}/health-check`);
        const response = await fetch(`http://localhost:8080/${appName}/health-check`, {
            timeout: 5000
        });


        if (!response.ok) {
            return { status: 'DOWN', details: 'HTTP ' + response.status }
        }

        const healthData = await response.json()
        return healthData
    } catch (error) {
        return { status: 'DOWN', details: error.message }
    }
}

async function waitForServiceHealth(serviceName, maxRetries = 10) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`⏳ Checking health of ${serviceName} (attempt ${i + 1}/${maxRetries})...`);
            const healthData = await checkHealth(serviceName);
            console.log(`Health check response:`, healthData);
            if (healthData.status === 'UP') {
                console.log(`✅ Service ${serviceName} is healthy`);
                return healthData;
            }
        } catch (error) {
            console.log(`⏳ Attempt ${i + 1}/${maxRetries}: Waiting for ${serviceName} to be healthy...`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error(`Service ${serviceName} did not become healthy within ${maxRetries * 2} seconds`);
}

function getUsedPorts(compose) {
    const ports = [];
    Object.values(compose.services || {}).forEach(service => {
        if (service.expose) {
            service.expose.forEach(port => {
                ports.push(parseInt(port));
            });
        }
    });
    return ports.sort((a, b) => a - b);
}

function getAvailablePorts(usedPorts) {
    const available = [];
    for (let port = 8081; port <= 8100; port++) {
        if (!usedPorts.includes(port)) {
            available.push(port);
        }
    }
    return available;
}

// Start server
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});