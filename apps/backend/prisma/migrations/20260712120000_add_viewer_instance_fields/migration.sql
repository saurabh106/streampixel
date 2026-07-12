-- AlterTable: Add per-viewer fields to Instance
ALTER TABLE "instances" ADD COLUMN "viewerId" TEXT,
ADD COLUMN "viewportWidth" INTEGER,
ADD COLUMN "viewportHeight" INTEGER;

-- CreateIndex: Unique constraint on (projectId, viewerId)
-- PostgreSQL allows multiple NULLs in a unique index, so owner instances
-- (viewerId = NULL) are not limited, while viewer instances are unique per project.
CREATE UNIQUE INDEX "instances_projectId_viewerId_key" ON "instances"("projectId", "viewerId");
