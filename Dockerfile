FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

USER root
RUN mkdir -p /data/sessions \
  && chown -R pwuser:pwuser /app /data

USER pwuser
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000
CMD ["node", "src/server.js"]
