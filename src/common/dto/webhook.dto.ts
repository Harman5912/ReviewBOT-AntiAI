import { IsString, IsNumber, IsOptional, IsObject } from 'class-validator';

export class WebhookPayloadDto {
  @IsString()
  action!: string;

  @IsNumber()
  number!: number;

  @IsObject()
  pull_request!: Record<string, any>;

  @IsObject()
  repository!: Record<string, any>;

  @IsOptional()
  @IsObject()
  organization?: Record<string, any>;

  @IsOptional()
  @IsObject()
  sender?: Record<string, any>;
}
