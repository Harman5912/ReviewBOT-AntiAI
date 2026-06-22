import {
  IsBoolean,
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  IsEnum,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Severity } from '../enums/finding.enums';

export class SecuritySettingsDto {
  @IsBoolean()
  @IsOptional()
  secretScan?: boolean = true;

  @IsBoolean()
  @IsOptional()
  dependencyCheck?: boolean = true;

  @IsBoolean()
  @IsOptional()
  sqlInjectionScan?: boolean = true;

  @IsBoolean()
  @IsOptional()
  xssScan?: boolean = true;
}

export class ReviewConfigDto {
  @IsBoolean()
  @IsOptional()
  auto_review?: boolean = true;

  @IsBoolean()
  @IsOptional()
  draft_prs?: boolean = false;

  @IsEnum(Severity)
  @IsOptional()
  severity_threshold?: Severity = Severity.NIT;

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(100)
  max_comments?: number = 25;

  @IsString()
  @IsOptional()
  tone?: string = 'professional';

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ignored_paths?: string[] = ['node_modules/**', 'vendor/**', 'dist/**', '*.lock'];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  banned_apis?: string[] = [];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  required_test_paths?: string[] = ['**/*.test.*', '**/*.spec.*'];

  @IsEnum(Severity)
  @IsOptional()
  fail_on_severity?: Severity = Severity.HIGH;

  @IsOptional()
  @ValidateNested()
  @Type(() => SecuritySettingsDto)
  security?: SecuritySettingsDto = new SecuritySettingsDto();
}
