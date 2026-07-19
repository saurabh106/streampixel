import {
  Controller,
  Post,
  Body,
  Get,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import {
  ApiTags,
  ApiOperation,
  ApiResponse as ApiSwaggerResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UserDto } from '../common/types/shared.types';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiSwaggerResponse({ status: 201, description: 'User successfully created' })
  @ApiSwaggerResponse({ status: 400, description: 'Invalid validation input' })
  @ApiSwaggerResponse({ status: 409, description: 'Email conflict' })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login user and issue tokens' })
  @ApiSwaggerResponse({ status: 200, description: 'Authentication successful' })
  @ApiSwaggerResponse({ status: 401, description: 'Unauthorized credentials' })
  async login(@Body() loginDto: LoginDto, @Res({ passthrough: true }) response: Response) {
    const { user, accessToken, refreshToken } = await this.authService.login(loginDto);

    // Set HTTPOnly refresh token cookie
    response.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return { user, accessToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and revoke refresh token' })
  @ApiSwaggerResponse({ status: 200, description: 'Logout successful' })
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const refreshToken = request.cookies['refresh_token'] || request.body.refreshToken;
    await this.authService.logout(refreshToken);
    response.clearCookie('refresh_token', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    });
    return { message: 'Logged out successfully' };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access and refresh tokens' })
  @ApiSwaggerResponse({ status: 200, description: 'Tokens rotated successfully' })
  @ApiSwaggerResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const refreshToken = request.cookies['refresh_token'] || request.body.refreshToken;
    try {
      const {
        user,
        accessToken,
        refreshToken: newRefreshToken,
      } = await this.authService.refreshTokens(refreshToken);

      response.cookie('refresh_token', newRefreshToken, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      return { user, accessToken };
    } catch (error) {
      response.clearCookie('refresh_token', {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
      });
      throw error;
    }
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiSwaggerResponse({ status: 200, description: 'Profile returned successfully' })
  @ApiSwaggerResponse({ status: 401, description: 'Unauthorized' })
  async getMe(@GetUser() user: UserDto) {
    return user;
  }
}
