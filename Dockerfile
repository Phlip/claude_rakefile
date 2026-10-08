FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /workspace
RUN apt-get update && apt-get install -y python3 python3-pip build-essential
CMD ["/bin/bash"]
