FROM quay.io/qasimtech/mega-md:latest

WORKDIR /root/mega-mdx

RUN git clone https://github.com/macksyn/MEGA-MDX . && \
    npm install && \
    npm run build

EXPOSE 5000

CMD ["npm", "run", "start:optimized"]
