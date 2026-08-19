-- CreateTable
CREATE TABLE "accounting_exchange_rates" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "rateType" TEXT NOT NULL DEFAULT 'VENTA',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_exchange_rates_currency_date_idx" ON "accounting_exchange_rates"("currency", "date");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_exchange_rates_date_currency_rateType_key" ON "accounting_exchange_rates"("date", "currency", "rateType");

