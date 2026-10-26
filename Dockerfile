# syntax=docker/dockerfile:1
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build -w apps/server && npm run build -w apps/web

# ---- API + Socket.IO instance ----
FROM node:25-alpine AS server
WORKDIR /app
ENV NODE_ENV=production
# The server bundle inlines @board/shared, so only third-party runtime deps are installed.
COPY apps/server/package.json ./package.json
RUN node -e "const p=require('./package.json');delete p.devDependencies;require('fs').writeFileSync('package.json',JSON.stringify(p))" \
 && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/apps/server/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]

# ---- nginx: static web app + sticky load balancer for the API instances ----
FROM nginx:1.31-alpine AS web
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
