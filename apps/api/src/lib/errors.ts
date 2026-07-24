export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export const badRequest = (message = 'bad request'): ApiHttpError =>
  new ApiHttpError(400, message);

export const notFound = (): ApiHttpError => new ApiHttpError(404, 'not found');
