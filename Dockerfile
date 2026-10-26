# Production Dockerfile for Pulse-Link
FROM node:20-alpine AS base

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

WORKDIR /usr/src/app

# Copy dependency manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Run as non-root user for security
USER node

# Use dumb-init as PID 1 to handle SIGINT/SIGTERM properly
CMD ["dumb-init", "node", "server.js"]
