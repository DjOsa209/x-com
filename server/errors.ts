export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED",
    public details?: any,
  ) {
    super(message);
  }
}
export const required = (value: any, label: string) => {
  if (value === undefined || value === null || value === "")
    throw new AppError(400, `请填写${label}`, "VALIDATION");
  return String(value);
};
