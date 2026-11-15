import { Type } from 'class-transformer';
import { IsUUID, IsIn, IsNotEmpty, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { WagerKind } from '../../domain/wager-transaction';

const DECIMAL_AMOUNT = /^\d+\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

export class MoneyRequestDto {
  @IsString()
  @Matches(DECIMAL_AMOUNT)
  amount!: string;

  @IsString()
  @Matches(CURRENCY)
  currency!: string;
}

export class CreateWalletRequestDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyRequestDto)
  initialBalance!: MoneyRequestDto;
}

export class SubmitWagerRequestDto {
  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  externalTransactionId!: string;

  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @IsUUID('all')
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  gameId!: string;

  @IsIn(Object.values(WagerKind))
  kind!: WagerKind;

  @ValidateNested()
  @Type(() => MoneyRequestDto)
  money!: MoneyRequestDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  referenceExternalTransactionId?: string;
}
