FROM quay.io/qasimtech/mega-md:latest

WORKDIR /root/mega-mdx

# Layer 1: Copy only package files first — cached unless dependencies change
COPY package.json package-lock.json ./
RUN npm install

# Layer 2: Copy source and build — only re-runs when code changes
COPY . .
RUN npm run build

EXPOSE 5000

CMD ["npm", "run", "start:optimized"]
