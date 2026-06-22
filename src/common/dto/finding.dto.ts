import {
  IsString,
  IsEnum,
  IsNumber,
  IsOptional,
  Min,
  Max,
  ValidateNested,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Severity, Category, SuggestionType, Side } from '../enums/finding.enums';

export class SuggestionDto {
  @IsEnum(SuggestionType)
  type!: SuggestionType;

  @IsString()
  @IsOptional()
  patch?: string;
}

export class FindingDto {
  @IsString()
  finding_id!: string;

  @IsEnum(Severity)
  severity!: Severity;

  @IsEnum(Category)
  category!: Category;

  @IsNumber()
  @Min(0)
  @Max(1)
  confidence!: number;

  @IsString()
  @IsOptional()
  cwe?: string;

  @IsString()
  file!: string;

  @IsNumber()
  start_line!: number;

  @IsNumber()
  end_line!: number;

  @IsEnum(Side)
  side: Side = Side.RIGHT;

  @IsString()
  title!: string;

  @IsString()
  explanation!: string;

  /**
   * A clear, human-readable explanation of WHAT the fix does and WHY it resolves
   * the issue. This is displayed in the PR review UI so developers understand
   * the remediation without reading the patch.
   *
   * Example: "Replaces string concatenation with parameterized query to prevent
   * SQL injection. The database driver will escape user input automatically."
   */
  @IsString()
  @IsOptional()
  fix_explanation?: string;

  @ValidateNested()
  @Type(() => SuggestionDto)
  suggestion!: SuggestionDto;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  evidence_refs: string[] = [];
}
