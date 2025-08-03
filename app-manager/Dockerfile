FROM node:18-alpine

# Install git and docker CLI
RUN apk add --no-cache \
    git \
    docker-cli \
    docker-compose

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install

# Create apps directory with correct permissions
# RUN mkdir -p /app/apps && \
#     chown -R node:node /app/apps

# Copy source code
COPY . .

# Switch to non-root user
# USER node

EXPOSE 3002

CMD ["npm", "start"]