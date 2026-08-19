-- CreateTable
CREATE TABLE "accounting_customers" (
    "id" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_products" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SERVICE',
    "unitPrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "unit" TEXT NOT NULL DEFAULT 'NIU',
    "igvAffected" BOOLEAN NOT NULL DEFAULT true,
    "isSubscription" BOOLEAN NOT NULL DEFAULT false,
    "incomeAccount" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_customers_name_idx" ON "accounting_customers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_customers_docType_docNumber_key" ON "accounting_customers"("docType", "docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_products_code_key" ON "accounting_products"("code");

-- CreateIndex
CREATE INDEX "accounting_products_kind_idx" ON "accounting_products"("kind");

-- CreateIndex
CREATE INDEX "accounting_products_isSubscription_idx" ON "accounting_products"("isSubscription");

