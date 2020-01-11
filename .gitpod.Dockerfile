FROM gitpod/workspace-full-vnc

USER gitpod

RUN sudo apt-get update \
    && sudo apt-get install -y libx11-dev \
       libxkbfile-dev \
       libsecret-1-dev \
       libgconf2–4 \
       libnss3
