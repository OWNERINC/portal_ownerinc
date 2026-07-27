FROM node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8
RUN apk add --no-cache openjdk21-jre && npm install --global firebase-tools@15.19.0
WORKDIR /workspace
COPY firebase.json .firebaserc ./
RUN sed -i 's/127\.0\.0\.1/0.0.0.0/g' firebase.json
EXPOSE 4000 4400 9099
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:4400/emulators >/dev/null || exit 1
CMD ["firebase", "emulators:start", "--only", "auth", "--project", "ownerinc-portal-interno-prod"]
