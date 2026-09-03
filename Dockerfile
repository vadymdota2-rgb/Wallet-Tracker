FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY start.sh /start.sh
COPY html/ /usr/share/nginx/html/
RUN chmod +x /start.sh
EXPOSE 8080
CMD ["/start.sh"]
