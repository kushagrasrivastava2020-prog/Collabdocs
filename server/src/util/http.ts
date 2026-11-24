export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found')
export const forbidden = (what = 'You do not have permission to do that') => new HttpError(403, what, 'forbidden')
export const badRequest = (what: string) => new HttpError(400, what, 'bad_request')
