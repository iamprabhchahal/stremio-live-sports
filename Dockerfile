FROM ghcr.io/puppeteer/puppeteer:latest

# We must set this explicitly so that puppeteer instances run properly in docker 
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY . .

# Render/Railway will inject process.env.PORT automatically at runtime
EXPOSE 7000

CMD ["npm", "start"]
