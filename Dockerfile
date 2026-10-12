FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
