import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { User } from './user.entity'

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  findAll(): Promise<User[]> {
    return this.users.find()
  }

  async findOne(id: number): Promise<User> {
    const user = await this.users.findOneBy({ id })
    if (!user) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  create(data: Pick<User, 'email' | 'name'>): Promise<User> {
    return this.users.save(this.users.create(data))
  }

  async update(id: number, data: Partial<User>): Promise<User> {
    await this.users.update(id, data)
    return this.findOne(id)
  }

  async remove(id: number): Promise<void> {
    await this.users.delete(id)
  }
}
