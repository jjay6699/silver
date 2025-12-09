FROM nginx:alpine
WORKDIR /usr/share/nginx/html
COPY . .
# Use envsubst to honor the PORT variable provided by Railway
COPY default.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=8080
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
