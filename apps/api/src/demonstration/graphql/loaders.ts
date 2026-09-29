import type DataLoader from 'dataloader';
import { createEntityLoader } from '../../starter/modules/graphql/dataloaders';
import type {
  DoctorRepository,
  PatientRepository,
} from '../modules/doctors/domain/doctor.repository';

/** Built once per request; see the memoisation warning in starter/modules/graphql/dataloaders.ts. */
export function createDemonstrationLoaders(
  doctors: DoctorRepository,
  patients: PatientRepository,
): Record<string, DataLoader<string, unknown>> {
  return {
    doctor: createEntityLoader(doctors),
    patient: createEntityLoader(patients),
  };
}
