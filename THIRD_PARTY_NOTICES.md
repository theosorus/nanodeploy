# Third-party notices

Original Nanodeploy source, documentation and assets are distributed under
the [MIT license](LICENSE), except for third-party material identified below.

## Fonts and lettering

- **Space Grotesk**, by the Space Grotesk Project Authors, is bundled as a self-hosted WOFF2 font.
  Its SIL Open Font License 1.1 is included in both
  [control-plane/public/fonts/SpaceGrotesk-OFL.txt](control-plane/public/fonts/SpaceGrotesk-OFL.txt)
  and [gate/public/fonts/SpaceGrotesk-OFL.txt](gate/public/fonts/SpaceGrotesk-OFL.txt).
  Keep those notices with redistributed copies of the font.
- The logo's letterforms were sampled from **Departure Mono**, by Helena Zhang.
  The font file itself is not included. See the [brand notes](docs/brand2/README.md)
  for attribution and the origin of the vector artwork.

## Dependencies and container images

npm packages and container base images retain their own licenses and notices.
Each Node project's `package-lock.json` records its dependency versions and
license metadata; installed package directories include upstream license files.
Dockerfiles and `docker-compose.yml` identify the platform's upstream images
and the Sablier plugin. Preserve their notices when redistributing dependencies
or built artifacts. The Nanodeploy MIT license does not replace their licenses.
