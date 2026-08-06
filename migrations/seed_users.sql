-- Seed user awal (hash bcrypt PHP-compatible, di-generate via bcryptjs)
INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES
('admin','$2a$10$9sYn/TLFSgZ9gqbXUlWQwesFlytnognwfC7.1n3gHyPJUXfjdVVo6','SuperAdmin','ALL','Administrator',''),
('walas7a','$2a$10$HTIWE8XpzPrv.hgF62vXuuPp4DI/8RgoOFoYYi5NKtGnrZWTqcXs.','Walikelas','7A','Siti Aminah, S.Pd','19850101'),
('19850101','$2a$10$cH9KTEPpxq0YNs6xyazk5un6NxYHZ7C5UEazE6bfXzO8paMhrLVBG','Guru','GURU','Siti Aminah, S.T','19850101'),
('toolman','$2a$10$w/A4wP03SFyZ/J8S3wvK4OCKzhuH9S0Y5U4Mk5zNi.Prq1AvpD6U2','Toolman','TKJ','Andi Prasetyo',''),
('sekret7a','$2a$10$qzuZGOHgvPbc7a5tQjSmReemtaUClsd9QkKT6htO0HAE8rx6w.xMy','Sekretaris','7A','Dewi Lestari',''),
('benda7a','$2a$10$bxXCvM.ScONbnIm3oPkBOup41Q4dhbkDAGPDRi9HOj6lkPxt6NxYK','Bendahara','7A','Ahmad Fauzi',''),
('ketua7a','$2a$10$NSzOiZtHm4GCrPbDEqnQOOXEIFmAXF2yXyljvwaXzq.sotZSUnw7i','Ketua','7A','Budi Santoso',''),
('001','$2a$10$Jd55oAG/J2mg8Qwc3.gPv.uqEDlGtn/IyYly.N50EU9aXDA13vvde','Siswa','7A','Ahmad Rizki',''),
('002','$2a$10$MwlXkXX3uYdXvfrut66Xu.vpiAHEMwZhR95yxSj1Mb9FLzfUjzFCG','Siswa','7A','Siti Nurhaliza','');
