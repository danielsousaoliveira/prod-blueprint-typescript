/**
 * Doctors and patients, referenced (not embedded) from appointments — documented design choice.
 *
 * That reference is precisely what creates the N+1 problem GraphQL is about to make
 * obvious: a query for 50 appointments, each asking for `doctor { name }`, naively issues
 * 51 database round trips. The batch method here is what DataLoader will call with the
 * accumulated ids.
 */

export interface Doctor {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly timezone: string;
}

export interface Patient {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
}

export interface DoctorRepository {
  findById(id: string): Promise<Doctor | null>;
  /**
   * Batch load.
   *
   * Returns a Map rather than an array deliberately: DataLoader must return results in
   * exactly the order it was given ids, and a missing record must map to `null` rather
   * than shifting every subsequent result by one. A Map makes that mapping explicit at
   * the call site instead of relying on the database preserving `$in` order — which it
   * does not guarantee.
   */
  findByIds(ids: readonly string[]): Promise<Map<string, Doctor>>;
  save(doctor: Doctor): Promise<void>;
}

export interface PatientRepository {
  findById(id: string): Promise<Patient | null>;
  findByIds(ids: readonly string[]): Promise<Map<string, Patient>>;
  save(patient: Patient): Promise<void>;
}

export const DOCTOR_REPOSITORY = Symbol('DOCTOR_REPOSITORY');
export const PATIENT_REPOSITORY = Symbol('PATIENT_REPOSITORY');

export const DOCTORS_COLLECTION = 'doctors';
export const PATIENTS_COLLECTION = 'patients';

/**
 * Counting hook for the N+1 test.
 *
 * The test needs to prove that DataLoader collapses 50 lookups into one QUERY — not into
 * one cached value, which a naive assertion on call count would also accept. Counting
 * actual database round trips is the only measurement that distinguishes those, so the
 * repository exposes a counter rather than the test spying on the driver.
 */
export class QueryCounter {
  private count = 0;

  increment(): void {
    this.count += 1;
  }

  get value(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
  }
}
