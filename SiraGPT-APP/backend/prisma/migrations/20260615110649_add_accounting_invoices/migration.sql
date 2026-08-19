-- CreateTable
CREATE TABLE "accounting_invoices" (
    "id" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT,
    "customerDoc" TEXT,
    "customerName" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "exchangeRate" DECIMAL(18,6),
    "gravado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "exonerado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "inafecto" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igv" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sunatStatus" TEXT,
    "sunatTicket" TEXT,
    "cdrHash" TEXT,
    "oseProvider" TEXT,
    "journalEntryId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "productId" TEXT,
    "code" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'NIU',
    "taxType" TEXT NOT NULL DEFAULT 'GRAVADO',
    "base" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igv" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "accounting_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_invoices_docType_idx" ON "accounting_invoices"("docType");

-- CreateIndex
CREATE INDEX "accounting_invoices_customerId_idx" ON "accounting_invoices"("customerId");

-- CreateIndex
CREATE INDEX "accounting_invoices_status_idx" ON "accounting_invoices"("status");

-- CreateIndex
CREATE INDEX "accounting_invoices_issueDate_idx" ON "accounting_invoices"("issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_invoices_series_number_key" ON "accounting_invoices"("series", "number");

-- CreateIndex
CREATE INDEX "accounting_invoice_lines_invoiceId_idx" ON "accounting_invoice_lines"("invoiceId");

-- AddForeignKey
ALTER TABLE "accounting_invoice_lines" ADD CONSTRAINT "accounting_invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "accounting_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

