FROM gitpod/workspace-full-vnc

USER gitpod

RUN apt-get update \
 && apt-get install -y libx11-dev libxkbfile-dev libsecret-1-dev libgconf2–4 libnss3