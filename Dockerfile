# Gunakan image Node.js versi stabil
FROM node:18

# Update sistem dan install library Linux yang WAJIB ada untuk Puppeteer/Chrome
# Ini yang biasanya bikin Error 502 kalau tidak diinstall
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set direktori kerja
WORKDIR /app

# Copy file package.json
COPY package*.json ./

# Install dependency project
RUN npm install

# Download Chrome Browser (Penting!)
RUN npx puppeteer browsers install chrome

# Copy seluruh source code backend (termasuk public_html)
COPY . .

# Buka port 3000 (sesuai app.js)
EXPOSE 3000

# Jalankan server
CMD [ "node", "app.js" ]