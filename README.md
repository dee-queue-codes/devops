# Setup Instructions:

1. Create the app-manager directory structure:
```
your-project-root/
├── docker-compose.yml (updated)
├── nginx.conf (updated)
├── dashboard.html (add the modal HTML)
├── app-manager/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js (the API code)
│   └── templates/ (optional, for dockerfile templates)
├── ecommerce-project/
├── blog-project/
└── inventory-project/
```

2. Copy the API code into app-manager/server.js

3. Run the setup:
```bash
cd app-manager
npm install
cd ..
docker-compose up --build
```

4. Access your dashboard at http://localhost:8080

5. Click the "New" button to create apps dynamically!

# Security Notes:
- The app-manager has access to Docker socket (needed for container management)
- GitHub PATs are handled securely but stored in environment variables
- Consider adding authentication for production use
- Validate all user inputs to prevent injection attacks

# What you can do now:
✅ Create new apps from GitHub repos through the dashboard
✅ Automatically generate Dockerfiles based on app type
✅ Set custom start commands and environment variables
✅ Auto-provision databases with volumes
✅ Update nginx routing automatically
✅ Support Node.js, Java, Python, Go, PHP, and custom apps

# Shutdown and restart
docker-compose down &&  docker-compose up --build -d

# Restart a specific service
docker-compose restart devops-app-manager-1
docker-compose restart devops-nginx-1

# Restart all services
docker-compose restart

# Stop a specific service
docker-compose stop devops-app-manager-1
docker-compose stop devops-nginx-1

# Start a specific service
docker-compose start devops-app-manager-1
docker-compose start devops-nginx-1

# Stop all services
docker-compose stop

# Start all services
docker-compose start

# Read logs
docker-compose logs

# Read logs of a specific service
docker-compose logs devops-app-manager-1
docker-compose logs devops-nginx-1

# Follow logs
docker-compose logs -f
docker-compose logs -f devops-app-manager-1
docker-compose logs -f devops-nginx-1

# Login to a specific container
docker exec -it devops-app-manager-1 /bin/bash
docker exec -it devops-nginx-1 /bin/bash