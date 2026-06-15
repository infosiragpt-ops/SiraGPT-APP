-- CreateTable
CREATE TABLE "accounting_accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "element" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "parentCode" TEXT,
    "nature" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "postable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_journal_entries" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "glosa" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "exchangeRate" DECIMAL(18,6),
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "periodId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_journal_lines" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounting_accounts_code_key" ON "accounting_accounts"("code");

-- CreateIndex
CREATE INDEX "accounting_accounts_element_idx" ON "accounting_accounts"("element");

-- CreateIndex
CREATE INDEX "accounting_accounts_parentCode_idx" ON "accounting_accounts"("parentCode");

-- CreateIndex
CREATE INDEX "accounting_accounts_postable_idx" ON "accounting_accounts"("postable");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_journal_entries_number_key" ON "accounting_journal_entries"("number");

-- CreateIndex
CREATE INDEX "accounting_journal_entries_date_idx" ON "accounting_journal_entries"("date");

-- CreateIndex
CREATE INDEX "accounting_journal_entries_status_idx" ON "accounting_journal_entries"("status");

-- CreateIndex
CREATE INDEX "accounting_journal_entries_source_sourceId_idx" ON "accounting_journal_entries"("source", "sourceId");

-- CreateIndex
CREATE INDEX "accounting_journal_entries_periodId_idx" ON "accounting_journal_entries"("periodId");

-- CreateIndex
CREATE INDEX "accounting_journal_lines_entryId_idx" ON "accounting_journal_lines"("entryId");

-- CreateIndex
CREATE INDEX "accounting_journal_lines_accountId_idx" ON "accounting_journal_lines"("accountId");

-- CreateIndex
CREATE INDEX "accounting_journal_lines_accountCode_idx" ON "accounting_journal_lines"("accountCode");

-- AddForeignKey
ALTER TABLE "accounting_journal_lines" ADD CONSTRAINT "accounting_journal_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "accounting_journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_journal_lines" ADD CONSTRAINT "accounting_journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounting_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

