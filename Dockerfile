FROM node:18-alpine

WORKDIR /app

# Copy project files
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

# Run with non-root user for security
USER node

CMD ["node", "server.js"]

