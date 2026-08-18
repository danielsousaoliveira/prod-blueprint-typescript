import { Injectable } from '@nestjs/common';
import type { Collection } from 'mongodb';
import { MongoService } from '../../../infra/mongo.service';
import {
  DOCTORS_COLLECTION,
  PATIENTS_COLLECTION,
  QueryCounter,
  type Doctor,
  type DoctorRepository,
  type Patient,
  type PatientRepository,
} from '../domain/doctor.repository';

/**
 * MongoDB adapters for the doctor and patient ports.
 *
 * Split out of `domain/` because the architectural lint rule caught them there — the
 * domain layer must not import the MongoDB driver. Worth recording rather than quietly
 * fixing: I had put the implementations next to the interfaces out of convenience, which
 * is precisely the erosion the rule exists to prevent, and it took the linter rather than
 * my own attention to notice.
 */

interface DoctorDocument {
  _id: string;
  name: string;
  specialty: string;
  timezone: string;
}

interface PatientDocument {
  _id: string;
  name: string;
  timezone: string;
}

@Injectable()
export class MongoDoctorRepository implements DoctorRepository {
  /** Exposed so the N+1 test can count real database round trips. */
  readonly queries = new QueryCounter();

  constructor(private readonly mongo: MongoService) {}

  private get collection(): Collection<DoctorDocument> {
    return this.mongo.db.collection<DoctorDocument>(DOCTORS_COLLECTION);
  }

  async findById(id: string): Promise<Doctor | null> {
    this.queries.increment();
    const doc = await this.collection.findOne({ _id: id });
    return doc ? toDoctor(doc) : null;
  }

  /**
   * One query for any number of ids. This is what DataLoader calls once per batch.
   */
  async findByIds(ids: readonly string[]): Promise<Map<string, Doctor>> {
    if (ids.length === 0) return new Map();
    this.queries.increment();

    const docs = await this.collection.find({ _id: { $in: [...ids] } }).toArray();
    return new Map(docs.map((doc) => [doc._id, toDoctor(doc)]));
  }

  async save(doctor: Doctor): Promise<void> {
    await this.collection.replaceOne(
      { _id: doctor.id },
      { name: doctor.name, specialty: doctor.specialty, timezone: doctor.timezone },
      { upsert: true },
    );
  }
}

@Injectable()
export class MongoPatientRepository implements PatientRepository {
  readonly queries = new QueryCounter();

  constructor(private readonly mongo: MongoService) {}

  private get collection(): Collection<PatientDocument> {
    return this.mongo.db.collection<PatientDocument>(PATIENTS_COLLECTION);
  }

  async findById(id: string): Promise<Patient | null> {
    this.queries.increment();
    const doc = await this.collection.findOne({ _id: id });
    return doc ? toPatient(doc) : null;
  }

  async findByIds(ids: readonly string[]): Promise<Map<string, Patient>> {
    if (ids.length === 0) return new Map();
    this.queries.increment();

    const docs = await this.collection.find({ _id: { $in: [...ids] } }).toArray();
    return new Map(docs.map((doc) => [doc._id, toPatient(doc)]));
  }

  async save(patient: Patient): Promise<void> {
    await this.collection.replaceOne(
      { _id: patient.id },
      { name: patient.name, timezone: patient.timezone },
      { upsert: true },
    );
  }
}

const toDoctor = (doc: DoctorDocument): Doctor => ({
  id: doc._id,
  name: doc.name,
  specialty: doc.specialty,
  timezone: doc.timezone,
});

const toPatient = (doc: PatientDocument): Patient => ({
  id: doc._id,
  name: doc.name,
  timezone: doc.timezone,
});
