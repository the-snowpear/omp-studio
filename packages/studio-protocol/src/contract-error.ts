export class ContractValidationError extends Error {
  constructor(
    message: string,
    readonly path = "$",
  ) {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
  }
}
