import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiResponse } from '../types/shared.types';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal server error';
    let details: any = null;
    let errorCode = 'INTERNAL_SERVER_ERROR';

    if (exception instanceof HttpException) {
      const resContent: any = exception.getResponse();
      message =
        typeof resContent === 'string' ? resContent : resContent.message || exception.message;
      if (typeof resContent === 'object') {
        details = resContent.message || null;
        errorCode = resContent.error || exception.name || 'HTTP_EXCEPTION';
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      errorCode = exception.name;
    }

    // Log the error for internal diagnostics
    if (status >= 500) {
      this.logger.error(`[${status}] ${message}`, exception.stack);
    } else {
      this.logger.warn(`[${status}] ${message}`);
    }

    const apiResponse: ApiResponse = {
      success: false,
      error: {
        code: errorCode.toUpperCase().replace(/[^A-Z0-9_]/gi, '_'),
        message: Array.isArray(details) ? 'Validation failed' : message,
        details: Array.isArray(details) ? details : undefined,
      },
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(apiResponse);
  }
}
