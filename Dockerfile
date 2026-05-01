FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 4000

CMD ["sh", "-c", "npm run db:migrate && npm start"]
