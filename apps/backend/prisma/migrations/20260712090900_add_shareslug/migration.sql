-- AlterTable
ALTER TABLE "projects" ADD COLUMN "shareSlug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "projects_shareSlug_key" ON "projects"("shareSlug");
