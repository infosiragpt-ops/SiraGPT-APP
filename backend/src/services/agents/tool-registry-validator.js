/**
 * tool-registry-validator.js
 *
 * Validates SiraGPT tool registry against manifest declarations.
 * Detects schema mismatches, missing tools, duplicate registrations.
 */

class ToolRegistryValidator {
  constructor(registry = {}, manifest = {}) {
    this.registry = registry;
    this.manifest = manifest;
    this.errors = [];
    this.warnings = [];
  }

  /**
   * Full validation pass
   */
  validate() {
    this.validateDeclarations();
    this.validateSchemas();
    this.validateAuthorization();
    this.validateBudgets();

    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
    };
  }

  /**
   * Check that all declared tools are registered
   */
  validateDeclarations() {
    for (const [toolId, manifest] of Object.entries(this.manifest)) {
      if (!this.registry[toolId]) {
        this.errors.push(`Tool ${toolId} declared in manifest but not registered`);
      }
    }

    for (const [toolId, impl] of Object.entries(this.registry)) {
      if (!this.manifest[toolId]) {
        this.warnings.push(`Tool ${toolId} registered but not declared in manifest`);
      }
    }
  }

  /**
   * Validate input/output schemas
   */
  validateSchemas() {
    for (const [toolId, manifesto] of Object.entries(this.manifest)) {
      const impl = this.registry[toolId];
      if (!impl) continue;

      // Check input schema exists
      if (manifesto.inputSchema && typeof manifesto.inputSchema !== 'object') {
        this.errors.push(`Tool ${toolId}: invalid inputSchema`);
      }

      // Check output format declared
      if (!manifesto.outputFormat) {
        this.warnings.push(`Tool ${toolId}: outputFormat not declared`);
      }

      // Validate output format is known
      const validFormats = ['text', 'json', 'svg', 'html', 'markdown', 'binary'];
      if (manifesto.outputFormat && !validFormats.includes(manifesto.outputFormat)) {
        this.errors.push(`Tool ${toolId}: unknown outputFormat ${manifesto.outputFormat}`);
      }
    }
  }

  /**
   * Validate authorization levels
   */
  validateAuthorization() {
    const validLevels = ['none', 'user', 'admin'];

    for (const [toolId, manifesto] of Object.entries(this.manifest)) {
      if (manifesto.authorization && !validLevels.includes(manifesto.authorization)) {
        this.errors.push(
          `Tool ${toolId}: invalid authorization level ${manifesto.authorization}`
        );
      }
    }
  }

  /**
   * Validate budget constraints
   */
  validateBudgets() {
    for (const [toolId, manifesto] of Object.entries(this.manifest)) {
      if (manifesto.budget) {
        const { maxCalls, timeoutMs } = manifesto.budget;

        if (maxCalls && (!Number.isInteger(maxCalls) || maxCalls <= 0)) {
          this.errors.push(`Tool ${toolId}: invalid maxCalls budget`);
        }

        if (timeoutMs && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
          this.errors.push(`Tool ${toolId}: invalid timeoutMs budget`);
        }
      }
    }
  }

  /**
   * Check if tool meets minimum requirements
   */
  isCompliant(toolId) {
    const manifesto = this.manifest[toolId];
    const impl = this.registry[toolId];

    if (!impl || !manifesto) return false;

    const requirements = [
      () => typeof manifesto.name === 'string',
      () => typeof manifesto.description === 'string',
      () => typeof manifesto.inputSchema === 'object',
      () => typeof manifesto.outputFormat === 'string',
      () => typeof impl === 'function',
    ];

    return requirements.every(req => req());
  }

  /**
   * List non-compliant tools
   */
  listNonCompliant() {
    const nonCompliant = [];

    for (const toolId of Object.keys(this.manifest)) {
      if (!this.isCompliant(toolId)) {
        nonCompliant.push(toolId);
      }
    }

    return nonCompliant;
  }

  /**
   * Get registry health score (0-100)
   */
  getHealthScore() {
    const total = Object.keys(this.manifest).length || 1;
    const compliant = total - this.listNonCompliant().length;
    const errorPenalty = this.errors.length * 5;

    return Math.max(0, 100 - errorPenalty - (((total - compliant) / total) * 100));
  }
}

module.exports = ToolRegistryValidator;
