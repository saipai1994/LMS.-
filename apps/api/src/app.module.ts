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
import { LmsController } from './lms/lms.controller';
import { QuizController } from './lms/quiz.controller';
import { GradesController } from './lms/grades.controller';
import { FilesController } from './lms/files.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { TransportController } from './transport/transport.controller';
import { LibraryController } from './library/library.controller';
import { InventoryController } from './inventory/inventory.controller';
import { HrController } from './hr/hr.controller';
import { HealthController } from './health/health.controller';
import { SecurityController } from './security/security.controller';
import { CampusLifeController } from './campus-life/campus-life.controller';
import { CommsController } from './comms/comms.controller';
import { SchedulingController } from './scheduling/scheduling.controller';
import { ReportsController } from './reports/reports.controller';
import { HealthProbeController } from './health.controller';
import { LifecycleController } from './lifecycle/lifecycle.controller';
import { ErrorFilter } from './common/errors.filter';

@Global()
@Module({
  controllers: [AuthController, PlatformController, AcademicsController, AdmissionsController, StudentsController, UsersController, DemoController, HostelController, IncidentsController, AttendanceController, DismissalController, NotificationsController, FinanceController, LmsController, QuizController, GradesController, FilesController, DashboardController, TransportController, LibraryController, InventoryController, HrController, HealthController, SecurityController, CampusLifeController, CommsController, SchedulingController, ReportsController, HealthProbeController, LifecycleController],
  providers: [DbService, AuthService, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: ErrorFilter }],
  exports: [DbService],
})
export class AppModule {}
