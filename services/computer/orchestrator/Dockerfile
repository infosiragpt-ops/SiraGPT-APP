FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev
COPY server.js ./
ENV PORT=8090 BIND=0.0.0.0
EXPOSE 8090
CMD ["node", "server.js"]
