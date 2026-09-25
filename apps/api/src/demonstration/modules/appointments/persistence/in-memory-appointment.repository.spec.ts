import { InMemoryAppointmentRepository } from './in-memory-appointment.repository';
import { runAppointmentRepositoryContract } from './appointment-repository.contract';

/**
 * The fake, held to exactly the same contract as MongoDB. Runs in milliseconds with no
 * container — which is the point of having it — but cannot claim any behaviour the real
 * adapter does not also demonstrate.
 */
runAppointmentRepositoryContract('in-memory', () => new InMemoryAppointmentRepository());
