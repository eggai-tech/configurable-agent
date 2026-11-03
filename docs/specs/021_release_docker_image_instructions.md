# Instructions

The `/invoke` leak fix (#31) is merged: investigate how to make a release. The release flow publishes to npm, but
the consumers deploy the GHCR image, and nothing builds it for a release tag. Fix the release workflow so that it
pushes the image too (option 1: a job in the publish workflow).
