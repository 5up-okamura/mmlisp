; GMLisp demo skeleton 1
; Purpose: loop/marker stability + base/delta modulation

(score :id :demo1-stage-loop
  :title "Demo 1 Stage Loop"
  :author "okamura"

  (part :main
    :loop true
    :ch [:fm1]

    (phrase :riff
      :tempo 120
      :len 1/8

      (marker :intro)
      (param-set :fm-fb 2)

      (loop-begin :a)
      (note :c4)
      (note :e4)
      (note :g4)
      (rest 1/8)
      (param-add :fm-fb +1)
      (note :a4)
      (rest 1/8)
      (param-add :fm-fb -1)
      (loop-end :a 4)

      (marker :turn)
      (note :f4 1/4)
      (rest 1/8)
      (jump :intro))))
