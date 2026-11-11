FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

EXPOSE 9117

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:9117/health || exit 1

USER node

CMD ["node", "index.js"]
