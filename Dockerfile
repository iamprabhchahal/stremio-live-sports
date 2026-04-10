FROM ghcr.io/puppeteer/puppeteer:latest


WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY . .

# Render/Railway will inject process.env.PORT automatically at runtime
EXPOSE 7000

CMD ["npm", "start"]
