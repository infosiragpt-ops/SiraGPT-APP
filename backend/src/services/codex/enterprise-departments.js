'use strict';

const WORKSTREAM_DEPARTMENTS = Object.freeze({
  mission_vision: 'ceo-office',
  software_landing: 'product-engineering',
  social_presence: 'marketing',
  inbox_customer_service: 'customer-success',
  customer_acquisition_sales: 'sales-operations',
  quality_assurance: 'trust',
});

const DEPARTMENT_ALIASES = Object.freeze({
  engineering: 'product-engineering',
  product: 'product-engineering',
  software: 'product-engineering',
  sales: 'sales-operations',
  revenue: 'sales-operations',
  support: 'customer-success',
  'trust-quality': 'trust',
  qa: 'trust',
  compliance: 'trust',
});

const ENTERPRISE_DEPARTMENT_IDS = Object.freeze([
  'ceo-office',
  'product-engineering',
  'marketing',
  'customer-success',
  'sales-operations',
  'trust',
]);
const ENTERPRISE_DEPARTMENT_ID_SET = new Set(ENTERPRISE_DEPARTMENT_IDS);

function canonicalDepartmentId(value) {
  const raw = String(value || '').trim().slice(0, 80);
  return WORKSTREAM_DEPARTMENTS[raw] || DEPARTMENT_ALIASES[raw] || raw;
}

function departmentIdForWorkstream(value, fallback = 'product-engineering') {
  return projectedEnterpriseDepartmentId(value, fallback);
}

function projectedEnterpriseDepartmentId(value, fallback = 'product-engineering') {
  const departmentId = canonicalDepartmentId(value);
  if (ENTERPRISE_DEPARTMENT_ID_SET.has(departmentId)) return departmentId;
  const fallbackId = canonicalDepartmentId(fallback);
  return ENTERPRISE_DEPARTMENT_ID_SET.has(fallbackId) ? fallbackId : 'product-engineering';
}

module.exports = {
  DEPARTMENT_ALIASES,
  ENTERPRISE_DEPARTMENT_IDS,
  WORKSTREAM_DEPARTMENTS,
  canonicalDepartmentId,
  departmentIdForWorkstream,
  projectedEnterpriseDepartmentId,
};
