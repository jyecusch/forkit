# Everything scripts/build-icons needs, so developers only need Docker.
FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends librsvg2-bin curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir fonttools==4.66.1 uharfbuzz==0.56.3

# Space Grotesk Bold, for the wordmark (SIL Open Font License).
ARG FONT_URL=https://registry.npmjs.org/@fontsource/space-grotesk/-/space-grotesk-5.3.0.tgz
ARG FONT_SHA256=2adb650694b6387b1862fee8b086a3a47ce9f32c10f20b8ec109aa1fcdfd07b7
RUN curl -fsSL "$FONT_URL" -o /tmp/font.tgz \
    && echo "$FONT_SHA256  /tmp/font.tgz" | sha256sum -c - \
    && mkdir -p /fonts \
    && tar xzf /tmp/font.tgz -C /tmp package/files/space-grotesk-latin-700-normal.woff \
    && python -c "from fontTools.ttLib import TTFont; f = TTFont('/tmp/package/files/space-grotesk-latin-700-normal.woff'); f.flavor = None; f.save('/fonts/SpaceGrotesk-Bold.ttf')" \
    && rm -rf /tmp/font.tgz /tmp/package

COPY build.sh wordmark.py pack.py /tools/
ENTRYPOINT ["/tools/build.sh"]
