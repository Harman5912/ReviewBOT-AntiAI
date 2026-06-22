import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

@Module({
  providers: [
    {
      provide: 'DATA_SOURCE',
      useFactory: async (configService: ConfigService) => {
        const dbType = configService.get('DATABASE_TYPE', 'sqlite');

        let dataSource: DataSource;

        if (dbType === 'sqlite') {
          dataSource = new DataSource({
            type: 'sqljs',
            database: Buffer.from([]),
            location: configService.get('DATABASE_NAME', 'reviewbot') + '.db',
            entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
            synchronize: true,
            logging: configService.get('NODE_ENV') === 'development',
          });
        } else {
          dataSource = new DataSource({
            type: 'postgres',
            host: configService.get('DATABASE_HOST', 'localhost'),
            port: configService.get('DATABASE_PORT', 5432),
            username: configService.get('DATABASE_USER', 'reviewbot'),
            password: configService.get('DATABASE_PASSWORD', ''),
            database: configService.get('DATABASE_NAME', 'reviewbot'),
            entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
            migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
            synchronize: configService.get('NODE_ENV') === 'development',
            logging: configService.get('NODE_ENV') === 'development',
            ssl:
              configService.get('NODE_ENV') === 'production'
                ? { rejectUnauthorized: false }
                : false,
          });
        }

        await dataSource.initialize();
        return dataSource;
      },
      inject: [ConfigService],
    },
  ],
  exports: ['DATA_SOURCE'],
})
export class DatabaseModule {}
