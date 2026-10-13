import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { DbService } from './db/db.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { PlatformController } from './tenants/platform.controller';
import { AcademicsController } from './academics/academics.controller';
import { AdmissionsController } from './admissions/admissions.controller';
import { StudentsController } from './sis/students.controller';
import { UsersController } from './tenants/users.controller';
import { DemoController } from './demo/demo.controller';
import { HostelController } from './hostel/hostel.controller';
import { IncidentsController } from './incidents/incidents.controller';
import { AttendanceController } from './attendance/attendance.controller';
import { DismissalController } from './dismissal/dismissal.controller';
import { NotificationsController } from './notifications/notifications.controller';
import { FinanceController } from './finance/finance.controller';
import { ErrorFilter } from './common/errors.filter';

@Global()
@Module({
  controllers: [AuthController, PlatformController, AcademicsController, AdmissionsController, StudentsController, UsersController, DemoController, HostelController, IncidentsController, AttendanceController, DismissalController, NotificationsController, FinanceController],
  providers: [DbService, AuthService, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: ErrorFilter }],
  exports: [DbService],
})
export class AppModule {}
