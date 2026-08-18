import { Global, Module } from '@nestjs/common';
import { DOCTOR_REPOSITORY, PATIENT_REPOSITORY } from './domain/doctor.repository';
import {
  MongoDoctorRepository,
  MongoPatientRepository,
} from './persistence/mongo-doctor.repository';

@Global()
@Module({
  providers: [
    { provide: DOCTOR_REPOSITORY, useClass: MongoDoctorRepository },
    { provide: PATIENT_REPOSITORY, useClass: MongoPatientRepository },
  ],
  exports: [DOCTOR_REPOSITORY, PATIENT_REPOSITORY],
})
export class DoctorsModule {}
