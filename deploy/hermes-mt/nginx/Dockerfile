# 前端静态 + 反代。构建前把浏览器版前端产物放到本目录 dist-browser/（见 README）。
#   docker build -t hermes-mt-nginx:dev .
FROM nginx:1.27-alpine
COPY hermes-mt.conf /etc/nginx/conf.d/default.conf
COPY dist-browser/ /usr/share/nginx/html/hermes/
