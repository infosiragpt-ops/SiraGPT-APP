-- Model A (git-backed real deploy): link a Deployments-module deployment to the
-- connected GitHub repo whose cloned workspace is the build/source dir for
-- hostinger_vps deploys. Nullable; no FK (resolved + ownership-checked in code).
ALTER TABLE "deployments" ADD COLUMN "connectedRepositoryId" TEXT;
